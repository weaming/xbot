/**
 * 看板：列 = 状态分组，跨列拖拽 = 改状态（语义由后端 move 接口决定）。
 *
 * 只用 dnd-kit 的 core（draggable + droppable）：列内排序没有持久化字段，
 * 与其做一个刷新就丢的假排序，不如先不做。
 */

import {
    DndContext,
    DragOverlay,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import type { BoardColumnKey, Job, JobState } from "../lib/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui";

interface ColumnDef {
    key: BoardColumnKey;
    title: string;
    /** 组内判定：有的列不能只靠 state 区分（待办 vs 手动都看 autoStart） */
    match: (job: Job) => boolean;
    droppable: boolean;
}

export const COLUMNS: ColumnDef[] = [
    // 「待办」= 会自动执行的排队任务；「手动」= 关掉 autoStart 的，等人点开始
    { key: "todo", title: "待办", match: job => job.state === "queued" && job.input.autoStart !== false, droppable: true },
    { key: "manual", title: "手动", match: job => job.state === "queued" && job.input.autoStart === false, droppable: true },
    { key: "doing", title: "进行中", match: job => job.state === "leased" || job.state === "running", droppable: true },
    {
        key: "review",
        title: "待处理",
        match: job => job.state === "failed" || job.state === "lost" || job.state === "interfered",
        droppable: false,
    },
    { key: "done", title: "已完成", match: job => job.state === "succeeded", droppable: true },
    { key: "cancelled", title: "已取消", match: job => job.state === "cancelled", droppable: true },
];

const STATE_TONE: Record<JobState, "default" | "accent" | "ok" | "warn" | "bad"> = {
    queued: "default",
    leased: "accent",
    running: "accent",
    succeeded: "ok",
    failed: "bad",
    lost: "bad",
    cancelled: "warn",
    interfered: "warn",
};

function jobTitle(job: Job): string {
    return job.input.title || job.input.prompt;
}

function CardBody({ job }: { job: Job }) {
    const labels = job.input.labels ?? [];
    return (
        <>
            <div className="text-sm leading-snug break-words">{jobTitle(job)}</div>
            {labels.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {labels.map(label => (
                        <span key={label} className="rounded-full bg-col px-2 py-0.5 text-xs text-muted">
                            {label}
                        </span>
                    ))}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
                {job.input.archivedAt && <span>已归档</span>}
                {job.input.autoStart === false && <span>手动</span>}
                {job.attempts > 0 && <span>×{job.attempts}</span>}
                <span className="font-mono">{job.id.slice(-6)}</span>
            </div>
        </>
    );
}

function DraggableCard({
    job,
    selected,
    focused,
    onSelect,
}: {
    job: Job;
    selected: boolean;
    /** 键盘焦点（Enter 打开）；与「详情已打开」是两件事 */
    focused: boolean;
    onSelect: () => void;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id, data: { job } });

    return (
        <article
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            onClick={onSelect}
            className={cn(
                // touch-none：移动端拖动卡片时不要连带滚动看板
                "flex touch-none cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-panel p-2.5 active:cursor-grabbing",
                // 选中只换边框色 + 一层极淡底：ring 会外扩压住列间距，视觉上发脏
                selected && "border-accent bg-accent/5",
                focused && !selected && "ring-2 ring-accent/60",
                isDragging && "dragging",
                job.input.archivedAt && "opacity-60",
            )}
        >
            <CardBody job={job} />
        </article>
    );
}

function Column({
    column,
    jobs,
    selectedId,
    focusId,
    onSelect,
}: {
    column: ColumnDef;
    jobs: Job[];
    selectedId: string | null;
    focusId: string | null;
    onSelect: (id: string) => void;
}) {
    const { setNodeRef, isOver } = useDroppable({ id: column.key, disabled: !column.droppable });

    return (
        <section
            ref={setNodeRef}
            className={cn(
                // 移动端一列占大半屏并支持横滑吸附，md 以上恢复固定列宽
                "flex h-full w-[85vw] max-w-[320px] shrink-0 snap-start flex-col gap-2 rounded-xl bg-col p-2 md:w-[280px]",
                isOver && "outline-2 outline-dashed outline-accent -outline-offset-2",
            )}
        >
            <header className="flex items-center gap-2 px-1 pt-1">
                <h3 className="text-sm font-semibold">{column.title}</h3>
                <span className="text-xs text-muted">{jobs.length}</span>
            </header>
            <div className="stable-scroll flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto">
                {jobs.map(job => (
                    <DraggableCard
                        key={job.id}
                        job={job}
                        selected={job.id === selectedId}
                        focused={job.id === focusId}
                        onSelect={() => onSelect(job.id)}
                    />
                ))}
            </div>
        </section>
    );
}

export function Board({
    jobs,
    selectedId,
    focusId,
    onSelect,
    onMove,
}: {
    jobs: Job[];
    selectedId: string | null;
    focusId: string | null;
    onSelect: (id: string) => void;
    onMove: (id: string, column: BoardColumnKey) => void;
}) {
    const [activeJob, setActiveJob] = useState<Job | null>(null);
    // 指针移动 4px 才起拖，避免点击卡片被误判成拖拽
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

    const handleDragStart = (event: DragStartEvent) => {
        const job = jobs.find(item => item.id === event.active.id);
        setActiveJob(job ?? null);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setActiveJob(null);
        const target = event.over?.id;
        if (typeof target !== "string") return;
        const job = jobs.find(item => item.id === event.active.id);
        if (!job) return;
        // 拖回原列不发请求：避免无意义的状态迁移
        const current = COLUMNS.find(column => column.match(job));
        if (current?.key === target) return;
        onMove(job.id, target as BoardColumnKey);
    };

    return (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex h-full snap-x snap-mandatory items-stretch gap-3 overflow-x-auto p-3 md:snap-none">
                {COLUMNS.map(column => (
                    <Column
                        key={column.key}
                        column={column}
                        jobs={jobs.filter(column.match)}
                        selectedId={selectedId}
                        focusId={focusId}
                        onSelect={onSelect}
                    />
                ))}
            </div>
            <DragOverlay>
                {activeJob ? (
                    <article className="flex w-[80vw] max-w-[300px] flex-col gap-1.5 rounded-lg border border-accent bg-panel p-2.5 shadow-lg md:w-[264px]">
                        <CardBody job={activeJob} />
                    </article>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}
