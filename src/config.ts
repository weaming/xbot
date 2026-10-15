// Token 预算与自动压缩配置
export const CONTEXT_WINDOW_TOKENS = parseInt(process.env.CONTEXT_WINDOW_TOKENS || '128000', 10);
export const RESERVED_OUTPUT_TOKENS = parseInt(process.env.RESERVED_OUTPUT_TOKENS || '8192', 10);
export const AUTOCOMPACT_BUFFER_TOKENS = parseInt(process.env.AUTOCOMPACT_BUFFER_TOKENS || '15000', 10);
export const RETAINED_TAIL_TOKENS = parseInt(process.env.RETAINED_TAIL_TOKENS || '12000', 10);
export const AUTOCOMPACT_PERCENTAGE = parseFloat(process.env.AUTOCOMPACT_PERCENTAGE || process.env.AUTOCOMPACT_PCT || '0.80');
export const TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS = parseInt(process.env.TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS || '8192', 10);
export const TOOL_RESULT_SUMMARY_HEAD_TOKENS = parseInt(process.env.TOOL_RESULT_SUMMARY_HEAD_TOKENS || '1024', 10);
export const TOOL_RESULT_SUMMARY_TAIL_TOKENS = parseInt(process.env.TOOL_RESULT_SUMMARY_TAIL_TOKENS || '2048', 10);
