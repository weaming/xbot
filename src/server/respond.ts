/** HTTP 响应与请求体工具：各前端路由共用，保持状态码与错误形状一致。 */

export function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

export function fail(message: string, status: number): Response {
    return json({ error: message }, status);
}

/** 读 JSON body；非法 JSON 返回 undefined，由调用方给 400。 */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed = await req.json();
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
