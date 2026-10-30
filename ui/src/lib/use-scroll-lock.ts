/**
 * 手机端禁止「整页被手指拖走」。
 *
 * 键盘弹起后（iOS Safari 尤其明显）可视区仍能被拖动：在输入框附近一拖，
 * 整个面板跟着手指滑，输入框和键盘之间就露出一条底色。`overflow: hidden`
 * 管得住滚动容器的余量，管不住这种系统级的可视区平移，只能拦 touchmove 的默认行为。
 *
 * 全拦会把时间线、看板、下拉菜单一起冻住，所以按事件路径判断：
 * 遇到（真能滚的）滚动容器就放行，其余一律不滚。输入框只在自身内容超出时才放行——
 * 整页不动优先于「拖动选词」，选词还有长按与双击。
 */

import { useEffect } from "react";

/** 能在这个方向上滚（且真的还有内容）才放行，否则滚动链会继续朝页面甩 */
function canScroll(node: HTMLElement): boolean {
    const scrollable = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
    if (!scrollable) return false;
    const style = getComputedStyle(node);
    return (
        ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) ||
        ((style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollWidth > node.clientWidth)
    );
}

export function useScrollLock(): void {
    useEffect(() => {
        const onTouchMove = (event: TouchEvent): void => {
            // 双指留给缩放：单指手势才拦
            if (event.touches.length > 1) return;
            let node = event.target as HTMLElement | null;
            while (node) {
                if (canScroll(node)) return;
                node = node.parentElement;
            }
            event.preventDefault();
        };

        // 必须非 passive，否则 preventDefault 无效
        document.addEventListener("touchmove", onTouchMove, { passive: false });
        return () => document.removeEventListener("touchmove", onTouchMove);
    }, []);
}
