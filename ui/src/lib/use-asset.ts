/** 图片资源：先带令牌 fetch 成 blob URL，再交给 `<img>`。 */

import { useEffect, useState } from "react";
import { fetchAssetUrl } from "./api";

/** 返回可直接放进 `src` 的 blob URL；取不到时返回 undefined（调用方不渲染图片）。 */
export function useAssetUrl(id?: string): string | undefined {
    const [url, setUrl] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (!id) {
            setUrl(undefined);
            return;
        }
        let cancelled = false;
        void fetchAssetUrl(id)
            .then(next => {
                if (!cancelled) setUrl(next);
            })
            .catch(() => {
                // 取不到就当作没有图片，不打断整条时间线
            });
        return () => {
            cancelled = true;
        };
    }, [id]);

    return url;
}
