declare module "*.md" {
    const content: string;
    export default content;
}

/**
 * bun 的 file loader：`with { type: "file" }` 导入的是文件路径字符串，
 * bundle 时 bun 会把该文件复制到输出目录并改成相对输出目录的路径。
 * 用 `.tokjson` 而不是 `.json`：TS 的 resolveJsonModule 会把 *.json 解析成对象，声明拦不住。
 */
declare module "*.tokjson" {
    const filePath: string;
    export default filePath;
}

interface ImportMeta {
    /** bun 提供的当前模块目录（源码运行与 bundle 后都可用）。 */
    dir: string;
}
