import type { ExecutableTool } from "./tool-interface.js";

const cleanedSchemaCache = new WeakMap<object, any>();

export function getCachedCleanedSchema(schema: any): any {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {} };
    }

    const cached = cleanedSchemaCache.get(schema);
    if (cached) {
        return cached;
    }

    const cleaned = cleanParametersForOpenAI(schema);
    cleanedSchemaCache.set(schema, cleaned);
    return cleaned;
}

export function formatToolDef(tool: ExecutableTool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description || "",
            parameters: getCachedCleanedSchema(tool.inputSchema),
        },
    };
}

/** 将工具 schema 转为 DeepSeek 可接受的正则表达式写法。 */
export function normalizeToolDefinitionsForDeepSeek(tools: any[]): any[] {
    return tools.map(tool => {
        const parameters = tool?.function?.parameters;
        if (!parameters || typeof parameters !== "object") {
            return tool;
        }

        return {
            ...tool,
            function: {
                ...tool.function,
                parameters: normalizeDeepSeekSchema(parameters),
            },
        };
    });
}

export function cleanParametersForOpenAI(schema: any): any {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {} };
    }

    const cleaned: any = {};

    if (schema.type) cleaned.type = schema.type;
    if (schema.description) {
        cleaned.description = schema.description || "";
    }

    if (schema.properties && typeof schema.properties === "object") {
        const cleanedProperties: Record<string, any> = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            cleanedProperties[key] = cleanProperty(value);
        }
        cleaned.properties = cleanedProperties;
    }

    if (Array.isArray(schema.required) && schema.required.length > 0) {
        cleaned.required = schema.required;
    }

    if (schema.items) {
        cleaned.items = cleanProperty(schema.items);
    }

    if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        cleaned.enum = schema.enum;
    }

    return cleaned;
}

function cleanProperty(prop: any): any {
    if (!prop || typeof prop !== "object") {
        return prop;
    }

    const cleaned: any = {};
    const allowedFields = [
        "type",
        "description",
        "enum",
        "items",
        "properties",
        "required",
        "default",
        "pattern",
        "format",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
    ];

    for (const field of allowedFields) {
        if (prop[field] === undefined) {
            continue;
        }

        if (field === "properties" && typeof prop[field] === "object") {
            const cleanedNested: Record<string, any> = {};
            for (const [key, value] of Object.entries(prop[field])) {
                cleanedNested[key] = cleanProperty(value);
            }
            cleaned[field] = cleanedNested;
            continue;
        }

        if (field === "items") {
            cleaned[field] = cleanProperty(prop[field]);
            continue;
        }

        if (field === "description" && typeof prop[field] === "string") {
            cleaned[field] = prop[field] || "";
            continue;
        }

        cleaned[field] = prop[field];
    }

    return cleaned;
}

function normalizeDeepSeekSchema(value: any, key?: string): any {
    if (key === "pattern" && typeof value === "string") {
        return value
            .replace(/\\0(?![0-9])/g, "\\x00")
            .replace(/\u0000/g, "\\x00");
    }

    if (Array.isArray(value)) {
        return value.map(item => normalizeDeepSeekSchema(item));
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
            entryKey,
            normalizeDeepSeekSchema(entryValue, entryKey),
        ]),
    );
}
