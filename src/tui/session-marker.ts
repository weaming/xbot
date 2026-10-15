/**
 * 会话状态标记：tab 条与会话面板共用同一套语义，避免同一会话在两处显示不一致。
 * 优先级：归档 → 运行中 → 当前选中 → 空闲。
 */

/**
 * 转圈帧：用几何四分区字符（U+25D0..U+25D3）而非 Braille 点阵（U+28xx）。
 * 点阵字形在等宽字体里绘制于字符格下半部，与 ●○ 及中文的视觉中线不齐，
 * 同一列切帧时会上下跳动；几何符号与 ●○ 同族，重心一致。
 */
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** spinner 首帧：面板未拿到实时帧时使用，与 SPINNER_FRAMES[0] 保持一致。 */
export const DEFAULT_SPINNER: string = SPINNER_FRAMES[0];

const ARCHIVED_MARKER = "✕";
/** 有提问在等用户作答：用 1 列宽的 `?`（emoji 是双列，会撑破 tab 的等宽排版）。 */
const QUESTION_MARKER = "?";
const ACTIVE_MARKER = "●";
const IDLE_MARKER = "○";
/** 其他实例持有：同为圆形与 ●○ 重心一致，靠内点区分「有人在别处开着」。 */
const OTHER_MARKER = "◎";
/** 未认领：点状空心圆读作「空位」，避免与「本实例空闲」的 ○ 混淆。 */
const FREE_MARKER = "◌";

/** 会话归属：本实例持有 / 其他实例持有 / 无人认领（tab 条只含本实例会话，不传此值）。 */
export type SessionOwnerState = "mine" | "other" | "free";

export interface SessionMarkerState {
    archived?: boolean;
    busy: boolean;
    active: boolean;
    /** 会话挂着未作答的提问（ask_user）：比「运行中」更需要用户注意。 */
    question?: boolean;
    /** 面板需要区分归属；缺省视为本实例，保持 tab 条语义不变。 */
    owner?: SessionOwnerState;
}

/**
 * 会话状态标记字符；spinner 由调用方按帧传入，面板与 tab 条因此同步转圈。
 * 优先级：归档 > 待作答 > 他实例持有 > 未认领 > 运行中 > 当前选中 > 空闲。
 */
export function sessionMarker(state: SessionMarkerState, spinner: string = DEFAULT_SPINNER): string {
    if (state.archived) return ARCHIVED_MARKER;
    if (state.question) return QUESTION_MARKER;
    if (state.owner === "other") return OTHER_MARKER;
    if (state.owner === "free") return FREE_MARKER;
    if (state.busy) return spinner;
    if (state.active) return ACTIVE_MARKER;
    return IDLE_MARKER;
}
