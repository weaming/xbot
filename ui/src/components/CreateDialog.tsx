import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { McpServer } from "../lib/types";
import { cn } from "../lib/utils";
import { abbreviateHome } from "../lib/format";
import { Button, Dialog, Field, Input } from "./ui";
import { TagInput } from "./TagInput";
import { DirInput } from "./DirInput";
import { MdEditor } from "./MdEditor";

export function CreateDialog({
    open,
    servers,
    defaultCwd,
    home,
    onClose,
    onCreated,
}: {
    open: boolean;
    servers: McpServer[];
    /** 服务端的默认工作目录：留空时用它，也作为输入框提示 */
    defaultCwd: string;
    home: string;
    onClose: () => void;
    onCreated: () => Promise<unknown>;
}) {
    const [prompt, setPrompt] = useState("");
    const [title, setTitle] = useState("");
    const [workspace, setWorkspace] = useState("");
    const [labels, setLabels] = useState<string[]>([]);
    const [timeoutSec, setTimeoutSec] = useState("");
    // 记「排除项」而不是「选中项」：默认全选，用户点掉哪个就排除哪个
    const [excluded, setExcluded] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const reset = () => {
        setPrompt("");
        setTitle("");
        setWorkspace("");
        setLabels([]);
        setTimeoutSec("");
        setExcluded([]);
        setError(null);
    };

    /** autoStart=false 停在待办；true 入队即跑。两个按钮共用一个提交路径。 */
    const submit = async (autoStart: boolean) => {
        // 标题必填；任务描述同样必填（它才是发给模型的内容）
        if (!title.trim()) {
            setError("标题必填");
            return;
        }
        if (!prompt.trim()) {
            setError("任务描述必填");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.createJob({
                prompt: prompt.trim(),
                title: title.trim(),
                idempotencyKey: crypto.randomUUID(),
                ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
                ...(labels.length > 0 ? { labels } : {}),
                ...(Number(timeoutSec) > 0 ? { timeoutSec: Number(timeoutSec) } : {}),
                // 全选时不传该字段（等价于「不限制」）；有排除项才落成具体列表
                ...(excluded.length > 0
                    ? { mcpServers: servers.map(server => server.name).filter(name => !excluded.includes(name)) }
                    : {}),
                autoStart,
            });
            reset();
            onClose();
            await onCreated();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} title="新任务" onClose={() => { reset(); onClose(); }}>
            <div className="flex flex-col gap-2.5">
                <Field label="标题（必填）">
                    <Input
                        value={title}
                        autoFocus
                        placeholder="给这张卡片起个名字"
                        onChange={event => setTitle(event.target.value)}
                    />
                </Field>
                <Field label="任务描述">
                    <MdEditor
                        value={prompt}
                        onChange={setPrompt}
                        rows={4}
                        placeholder="要 zbot 做什么？"
                    />
                </Field>
                <Field label="工作目录（留空用 serve 的 cwd）">
                    <DirInput
                        value={workspace}
                        placeholder={
                            defaultCwd ? `留空用 ${abbreviateHome(defaultCwd, home)}` : "留空用 serve 的 cwd"
                        }
                        onChange={setWorkspace}
                    />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="标签，逗号分隔">
                        <TagInput
                            value={labels}
                            onChange={setLabels}
                            placeholder="输入后按逗号或回车"
                        />
                    </Field>
                    <Field label="超时（秒）">
                        <Input
                            type="number"
                            min={1}
                            value={timeoutSec}
                            onChange={event => setTimeoutSec(event.target.value)}
                        />
                    </Field>
                </div>
                <Field label="允许的 MCP">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {servers.length === 0 && <span className="text-xs text-muted">（没有可选的 MCP）</span>}
                        {servers.map(server => {
                            const checked = !excluded.includes(server.name);
                            return (
                                <button
                                    key={server.name}
                                    type="button"
                                    onClick={() =>
                                        setExcluded(current =>
                                            checked
                                                ? [...current, server.name]
                                                : current.filter(item => item !== server.name),
                                        )
                                    }
                                    className={cn(
                                        "rounded-full border px-2.5 py-0.5 text-xs",
                                        checked ? "border-accent text-accent" : "border-border text-muted",
                                    )}
                                >
                                    {server.name} ({server.toolCount})
                                </button>
                            );
                        })}
                        {servers.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setExcluded(servers.map(server => server.name))}
                                className="ml-auto rounded-full px-2 py-0.5 text-xs text-muted underline-offset-2 hover:underline"
                            >
                                清空
                            </button>
                        )}
                    </div>
                </Field>
                {error && <p className="text-xs text-bad">{error}</p>}
                <div className="flex justify-end gap-2">
                    <Button onClick={() => { reset(); onClose(); }}>取消</Button>
                    <Button disabled={busy} onClick={() => void submit(false)}>
                        创建
                    </Button>
                    <Button variant="primary" disabled={busy} onClick={() => void submit(true)}>
                        创建并开始
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}
