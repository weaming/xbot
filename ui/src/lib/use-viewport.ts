/**
 * 把手机「可视区」写进 CSS 变量。
 *
 * 软键盘弹起时 iOS Safari 不缩布局视口（100dvh 不变），而是把可视区往上滚，
 * 整页跟着上移；Android Chrome 靠 interactive-widget=resizes-content 缩布局视口。
 * 两边 visualViewport 的数值同口径，所以统一按可视区约束浮层：
 *
 *   --vv-height  可视区高度（键盘占掉的部分不算）
 *   --vv-top     可视区相对布局视口的偏移（iOS 自动滚动时需要）
 *   --vv-bottom  可视区底边到布局视口底边的距离（键盘占掉的部分）
 *
 * 只写 CSS 变量，不触发 re-render，也不合帧：合帧会晚一帧，拖动时正好看出抖动。
 */

import { useEffect } from "react";

export function useVisualViewport(): void {
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        const root = document.documentElement;

        const apply = (): void => {
            // 双指缩放时可视区也跟着变，但那是"放大镜"，不该当成键盘让面板重排
            if (Math.abs(viewport.scale - 1) > 0.01) return;
            root.style.setProperty("--vv-height", `${Math.round(viewport.height)}px`);
            root.style.setProperty("--vv-top", `${Math.round(viewport.offsetTop)}px`);
            root.style.setProperty(
                "--vv-bottom",
                `${Math.round(document.documentElement.clientHeight - viewport.offsetTop - viewport.height)}px`,
            );
        };

        apply();
        viewport.addEventListener("resize", apply);
        viewport.addEventListener("scroll", apply);
        return () => {
            viewport.removeEventListener("resize", apply);
            viewport.removeEventListener("scroll", apply);
            root.style.removeProperty("--vv-height");
            root.style.removeProperty("--vv-top");
            root.style.removeProperty("--vv-bottom");
        };
    }, []);
}
