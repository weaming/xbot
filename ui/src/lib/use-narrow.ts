/**
 * 窄屏（< md 断点）判定。
 *
 * 只有确实要按屏宽切换"结构"时才用（如 <select> 选项文案、输入区是否折叠）；
 * 纯样式差异交给 Tailwind 断点，别在这里堆条件。
 */

import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)";

export function useNarrow(): boolean {
    const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);

    useEffect(() => {
        const media = window.matchMedia(QUERY);
        const onChange = (): void => setNarrow(media.matches);
        // 首帧到 effect 之间可能已经转过屏，这里对齐一次
        onChange();
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);

    return narrow;
}
