/**
 * 粘贴输入子系统（两个组件）：
 *
 * 1. PasteAssembler：bracketed paste 组装器，把 stdin 中分片/交错到达的
 *    粘贴序列（\x1b[200~ ... \x1b[201~）汇总成完整序列再交给编辑器。
 *    终端（含 herdr 等转发层）可能把一次粘贴拆成多个数据块，两次粘贴的
 *    数据也可能粘在同一块里；若直接转发，编辑器的 paste 状态机在多分片/
 *    交错时序下可能丢失前一段内容，或把粘贴内容里的换行误判为 Enter
 *    而提前提交。本类保证编辑层永远只收到「一个完整 paste 序列」或
 *    「普通数据」，且内容按到达顺序完整保留（宁可多保留，绝不丢）。
 *
 * 2. SessionPasteStore：会话级 paste 缓存，绑定 marker 内容到会话。
 *    pi-tui 编辑器的 pastes Map（[paste #N ...] marker 的内容）是全局单例，
 *    setText/切会话会清空它；若输入框里残留 marker 文本而 Map 已重建，
 *    新粘贴会复用旧 id，提交展开时前一段内容被后一段覆盖。
 *    该存储按会话保存/恢复 pastes 内容与计数器，保证 marker 文本与
 *    Map 始终对齐。
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** 返回单个完整 paste 序列；非 paste 数据原样返回（数组）。 */
export class PasteAssembler {
    private buffer = "";
    private inPaste = false;

    push(data: string): string[] {
        const out: string[] = [];
        let work = data;

        while (work.length > 0) {
            if (this.inPaste) {
                const endIndex = work.indexOf(PASTE_END);
                const restartIndex = work.indexOf(PASTE_START);
                if (endIndex >= 0 && (restartIndex < 0 || restartIndex > endIndex)) {
                    // 正常结束：把累积内容补完，输出完整序列。
                    this.buffer += work.slice(0, endIndex);
                    if (this.buffer.length > 0) {
                        out.push(`${PASTE_START}${this.buffer}${PASTE_END}`);
                    }
                    this.buffer = "";
                    this.inPaste = false;
                    work = work.slice(endIndex + PASTE_END.length);
                    continue;
                }
                if (restartIndex >= 0 && (endIndex < 0 || restartIndex < endIndex)) {
                    // 上一段未闭合就来了新的段头（交错/异常）：先补完上一段不丢，
                    // 然后从新的段头继续累积。
                    if (this.buffer.length > 0) {
                        out.push(`${PASTE_START}${this.buffer}${PASTE_END}`);
                    }
                    this.buffer = "";
                    work = work.slice(restartIndex + PASTE_START.length);
                    continue;
                }
                // 普通内容：累积，等待结束标记。
                this.buffer += work;
                work = "";
                continue;
            }

            const startIndex = work.indexOf(PASTE_START);
            const danglingEnd = work.indexOf(PASTE_END);
            if (danglingEnd >= 0 && (startIndex < 0 || danglingEnd < startIndex)) {
                // 孤立结束标记（前一段残留/异常输入）：丢弃，避免污染编辑层。
                work = work.slice(danglingEnd + PASTE_END.length);
                continue;
            }
            if (startIndex < 0) {
                out.push(work);
                work = "";
                continue;
            }
            if (startIndex > 0) {
                out.push(work.slice(0, startIndex));
            }
            this.inPaste = true;
            this.buffer = "";
            work = work.slice(startIndex + PASTE_START.length);
        }

        return out;
    }
}

/** 会话级 paste 缓存：按会话保存/恢复 pastes 内容与计数器。 */
export class SessionPasteStore {
    private readonly bySession = new Map<string, Map<number, string>>();

    /** 保存某会话当前的全部 paste 内容（深拷贝，避免后续修改污染缓存）。 */
    save(sessionId: string, pastes: Map<number, string> | undefined): void {
        if (!pastes || pastes.size === 0) return;
        this.bySession.set(sessionId, new Map(pastes));
    }

    /**
     * 恢复某会话缓存的 paste 内容到编辑器 Map，并把 counter 设为 max(id)
     * （pi-tui 的大粘贴路径先 pasteCounter++ 再使用，因此下一个新建 marker 的
     * id 正好是 max(id)+1，序号保持连续且不与已恢复的冲突）。
     * 无缓存时返回 false（调用方保持现状）。
     */
    restore(sessionId: string, pastes: Map<number, string> | undefined, counter: { value: number }): boolean {
        const cached = this.bySession.get(sessionId);
        if (!cached || !pastes) return false;
        pastes.clear();
        let maxId = 0;
        for (const [id, content] of cached) {
            pastes.set(id, content);
            if (id > maxId) maxId = id;
        }
        counter.value = maxId;
        return true;
    }

    /** 会话删除/归档时清理其缓存，避免陈旧 marker 残留。 */
    clear(sessionId: string): void {
        this.bySession.delete(sessionId);
    }

    /** 读取某会话缓存的 paste 内容（落盘草稿时展开 marker 用）。 */
    get(sessionId: string): Map<number, string> | undefined {
        return this.bySession.get(sessionId);
    }
}
