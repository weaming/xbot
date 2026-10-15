/** 模型选择浮层：依次选择协议、模型，以及是否将该模型设为默认。 */

import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ChatModelSelection } from "../types/chat-model.js";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { truncatePlain } from "./panel-text.js";
import { theme } from "./theme.js";

type Step = "protocol" | "model" | "default";

export interface ModelPanelOptions {
    options: ChatModelSelection[];
    current?: ChatModelSelection;
    visibleRows: number;
    close(): void;
    complete(selection: ChatModelSelection, makeDefault: boolean): void | Promise<void>;
}

export class ModelPanel implements Component {
    private readonly root = new PanelBody();
    private step: Step = "protocol";
    private protocolIndex = 0;
    private modelIndex = 0;
    private defaultIndex = 0;
    private cursor = 0;

    constructor(private readonly options: ModelPanelOptions) {
        const protocols = this.protocols();
        const currentProtocol = options.current?.protocol;
        this.protocolIndex = Math.max(0, protocols.findIndex(protocol => protocol === currentProtocol));
        this.cursor = this.protocolIndex;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.options.close();
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            this.goBack();
            return;
        }
        if (handlePanelScroll(data, {
            pageSize: this.options.visibleRows,
            scrollBy: delta => this.moveCursor(delta),
            vimKeys: false,
        })) return;
        if (!matchesKey(data, Key.enter)) return;

        if (this.step === "protocol") {
            this.protocolIndex = this.cursor;
            this.step = "model";
            const current = this.options.current;
            const models = this.models();
            const currentIndex = models.findIndex(option =>
                option.protocol === current?.protocol && option.model === current?.model,
            );
            this.modelIndex = Math.max(0, currentIndex);
            this.cursor = this.modelIndex;
            return;
        }
        if (this.step === "model") {
            this.modelIndex = this.cursor;
            this.step = "default";
            this.defaultIndex = 0;
            this.cursor = 0;
            return;
        }

        this.defaultIndex = this.cursor;
        const selection = this.models()[this.modelIndex];
        if (selection) void this.options.complete(selection, this.defaultIndex === 1);
    }

    render(width: number): string[] {
        const choices = this.choices();
        const maxChoices = Math.max(1, this.options.visibleRows - 4);
        const start = Math.max(0, Math.min(this.cursor - maxChoices + 1, choices.length - maxChoices));
        const visible = choices.slice(start, start + maxChoices);
        const lines = visible.map((choice, index) => {
            const itemIndex = start + index;
            const prefix = itemIndex === this.cursor ? "❯ " : "  ";
            return new Text(`${prefix}${truncatePlain(choice, Math.max(1, width - 4))}`, 1, 0);
        });
        const stepLabel = this.step === "protocol" ? "1/3 选择协议"
            : this.step === "model" ? "2/3 选择模型"
                : "3/3 设为默认？";
        const header = new Text(theme.commandBorder(`模型设置 · ${stepLabel}`), 1, 0);
        const footer = new Text(theme.dim("↑↓ 选择 · Enter 确认 · Backspace 返回 · Esc 关闭"), 1, 0);
        this.root.setChildren([header, ...lines, footer]);
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }

    private protocols(): ChatModelSelection["protocol"][] {
        return [...new Set(this.options.options.map(option => option.protocol))];
    }

    private models(): ChatModelSelection[] {
        const protocol = this.protocols()[this.protocolIndex];
        return this.options.options.filter(option => option.protocol === protocol);
    }

    private choices(): string[] {
        if (this.step === "protocol") {
            return this.protocols().map(protocol => protocol === "responses" ? "Responses API" : "Chat Completions");
        }
        if (this.step === "model") return this.models().map(option => option.model);
        return ["否（仅应用到当前会话）", "是（同时设为默认模型）"];
    }

    private moveCursor(delta: number): void {
        const maxIndex = Math.max(0, this.choices().length - 1);
        this.cursor = Math.max(0, Math.min(maxIndex, this.cursor + delta));
        this.root.invalidate();
    }

    private goBack(): void {
        if (this.step === "default") {
            this.step = "model";
            this.cursor = this.modelIndex;
        } else if (this.step === "model") {
            this.step = "protocol";
            this.cursor = this.protocolIndex;
        }
        this.root.invalidate();
    }
}
