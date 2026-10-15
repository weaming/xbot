import type {
    EditorTheme,
    MarkdownTheme as PiMarkdownTheme,
    SelectListTheme,
} from "@earendil-works/pi-tui";

/**
 * TUI 颜色主题：ANSI 转义风格函数（pi-tui 组件要求 (text) => styled 形式）。
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const UNDERLINE = "\x1b[4m";
const STRIKETHROUGH = "\x1b[9m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const BRIGHT_BLUE = "\x1b[94m";
const BG_BLUE = "\x1b[44m";
const TAB_ACTIVE_BACKGROUND = "\x1b[48;5;24m";
const TAB_INACTIVE_BACKGROUND = "\x1b[48;5;238m";
const PANEL_BACKGROUND = "\x1b[48;5;236m";
const USER_BACKGROUND = "\x1b[48;5;238m";
/** 群消息统一素色背景（与面板同色），不区分发送者。 */
const CHAT_BACKGROUND = "\x1b[48;5;236m";

function paint(code: string, text: string): string {
    return `${code}${text}${RESET}`;
}

/** 背景色：每个 ANSI RESET 之后补回背景色，避免内嵌前景色把背景清掉。 */
function paintBackground(code: string, text: string): string {
    return `${code}${text.replaceAll(RESET, `${RESET}${code}`)}${RESET}`;
}

export const theme = {
    user: (text: string): string => paint(BOLD + BRIGHT_BLUE, text),
    userBackground: (text: string): string => paintBackground(USER_BACKGROUND, text),
    panelBackground: (text: string): string => paintBackground(PANEL_BACKGROUND, text),
    assistant: (text: string): string => text,
    reasoning: (text: string): string => paint(GRAY + DIM, text),
    tool: (text: string): string => paint(MAGENTA, text),
    toolArgs: (text: string): string => paint(GRAY, text),
    toolResult: (text: string): string => paint(GRAY + DIM, text),
    toolError: (text: string): string => paint(RED + DIM, text),
    toolDiffAdded: (text: string): string => paint(GREEN, text),
    toolDiffRemoved: (text: string): string => paint(RED, text),
    toolDiffDeleted: (text: string): string => paint(STRIKETHROUGH + RED, text),
    toolSelected: (text: string): string => paint(BG_BLUE + BOLD, text),
    system: (text: string): string => paint(GRAY, text),
    chatRoom: (text: string): string => paint(BOLD + BLUE, text),
    chatMention: (text: string): string => paint(BOLD + YELLOW, text),
    chatSelf: (text: string): string => paint(BOLD + GREEN, text),
    chatBackground: (text: string): string => paintBackground(CHAT_BACKGROUND, text),
    chatBody: (text: string): string => paint(GRAY, text),
    tabActive: (text: string): string => paint(TAB_ACTIVE_BACKGROUND + BOLD + CYAN, text),
    tabInactive: (text: string): string => paint(TAB_INACTIVE_BACKGROUND + GRAY, text),
    commandText: (text: string): string => paint(BOLD + CYAN, text.replaceAll(RESET, `${RESET}${BOLD + CYAN}`)),
    statusOk: (text: string): string => paint(GREEN, text),
    statusWarn: (text: string): string => paint(BOLD + YELLOW, text),
    statusBad: (text: string): string => paint(RED, text),
    commandBorder: (text: string): string => paint(BOLD + CYAN, text),
    /** 提问浮层：与工具块同色系，和其它浮层区分开。 */
    question: (text: string): string => paint(BOLD + MAGENTA, text),
    dim: (text: string): string => paint(DIM, text),
};

/** 消息正文的 Markdown 主题（标题/链接/代码/引用等）。 */
export const markdownTheme: PiMarkdownTheme = {
    heading: (text: string): string => paint(BOLD + BLUE, text),
    link: (text: string): string => paint(CYAN + UNDERLINE, text),
    linkUrl: (text: string): string => paint(GRAY + UNDERLINE, text),
    code: (text: string): string => paint(CYAN, text),
    codeBlock: (text: string): string => paint(CYAN, text),
    codeBlockBorder: (text: string): string => paint(DIM, text),
    quote: (text: string): string => paint(GRAY, text),
    quoteBorder: (text: string): string => paint(DIM, text),
    hr: (text: string): string => paint(DIM, text),
    listBullet: (text: string): string => paint(DIM, text),
    bold: (text: string): string => paint(BOLD, text),
    italic: (text: string): string => paint(DIM, text),
    strikethrough: (text: string): string => paint(DIM, text),
    underline: (text: string): string => paint(UNDERLINE, text),
};

/** 思考区（reasoning）的 Markdown 主题：所有元素统一浅灰，避免彩色干扰。 */
export const reasoningMarkdownTheme: PiMarkdownTheme = {
    heading: (text: string): string => theme.reasoning(text),
    link: (text: string): string => theme.reasoning(text),
    linkUrl: (text: string): string => theme.reasoning(text),
    code: (text: string): string => theme.reasoning(text),
    codeBlock: (text: string): string => theme.reasoning(text),
    codeBlockBorder: (text: string): string => theme.reasoning(text),
    quote: (text: string): string => theme.reasoning(text),
    quoteBorder: (text: string): string => theme.reasoning(text),
    hr: (text: string): string => theme.reasoning(text),
    listBullet: (text: string): string => theme.reasoning(text),
    bold: (text: string): string => theme.reasoning(text),
    italic: (text: string): string => theme.reasoning(text),
    strikethrough: (text: string): string => theme.reasoning(text),
    underline: (text: string): string => theme.reasoning(text),
};

/** 斜杠命令补全弹窗与会话面板共用的列表主题。 */
export const selectListTheme: SelectListTheme = {
    selectedPrefix: (text: string): string => paint(CYAN, text),
    selectedText: (text: string): string => paint(BOLD + BRIGHT_BLUE, text),
    description: (text: string): string => paint(GRAY, text),
    scrollInfo: (text: string): string => paint(DIM, text),
    noMatch: (text: string): string => paint(GRAY, text),
};

/** Editor 主题：斜杠命令输入时边框高亮（onChange 动态切换）。 */
export const editorTheme: EditorTheme = {
    borderColor: (text: string): string => paint(DIM, text),
    selectList: selectListTheme,
};
