import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { getResponsesBaselineFile } from "../../utils/state-paths.js";

export interface ResponseBaseline {
  request: Record<string, any>;
  responseId: string;
  output: any[];
}

const MAX_BASELINE_BYTES = 2_000_000;
const MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

/** 与上游地址及认证绑定，避免跨账号续接。 */
export function responsesIdentity(baseURL: string, apiKey: string, organization?: string | null, project?: string | null): string {
  return createHash("sha256").update(JSON.stringify([baseURL, apiKey, organization, project])).digest("hex");
}

/** 仅在请求选项和完整上下文前缀一致时使用增量续接。 */
export function buildResponsesContinuation(request: Record<string, any>, baseline?: ResponseBaseline): Record<string, any> {
  if (!baseline || request.previous_response_id !== undefined || !Array.isArray(request.input)
    || !Array.isArray(baseline.request.input)) return request;

  const { input: previousInput, ...previousOptions } = baseline.request;
  const { input: currentInput, ...currentOptions } = request;
  if (!isDeepStrictEqual(previousOptions, currentOptions)) return request;
  const prefix = [...previousInput, ...baseline.output];
  if (prefix.length > currentInput.length || !prefix.every((item, index) => isDeepStrictEqual(item, currentInput[index]))) {
    return request;
  }
  return { ...request, previous_response_id: baseline.responseId, input: currentInput.slice(prefix.length) };
}

export class ResponsesBaselineStore {
  constructor(private readonly sessionId: string | undefined, private readonly identity: string) {}

  async load(): Promise<ResponseBaseline | undefined> {
    if (!this.sessionId) return undefined;
    try {
      const file = getResponsesBaselineFile(this.sessionId);
      const stat = await fs.stat(file);
      if (stat.size > MAX_BASELINE_BYTES || Date.now() - stat.mtimeMs > MAX_AGE_MS) {
        await fs.rm(file, { force: true });
        return undefined;
      }
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.identity !== this.identity || typeof value.responseId !== "string"
        || !Array.isArray(value.request?.input) || value.request.store !== true || !Array.isArray(value.output)) return undefined;
      return { request: value.request, responseId: value.responseId, output: value.output };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("读取 Responses 续接基准失败:", error);
      return undefined;
    }
  }

  async save(baseline: ResponseBaseline): Promise<void> {
    if (!this.sessionId || baseline.request.store !== true) return;
    const serialized = JSON.stringify({ identity: this.identity, ...baseline });
    if (Buffer.byteLength(serialized) > MAX_BASELINE_BYTES) {
      await deleteResponsesBaseline(this.sessionId);
      return;
    }
    const file = getResponsesBaselineFile(this.sessionId);
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temp, serialized, { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async clear(): Promise<void> {
    if (this.sessionId) await deleteResponsesBaseline(this.sessionId);
  }
}

export async function deleteResponsesBaseline(sessionId: string): Promise<void> {
  await fs.rm(getResponsesBaselineFile(sessionId), { force: true });
}
