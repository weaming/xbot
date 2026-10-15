import { describe, expect, test } from "bun:test";
import { createUlid } from "../../src/utils/ulid.js";

describe("ULID", () => {
    test("creates sortable canonical identifiers", () => {
        const timestamp = new Date(Date.now() + 60_000);
        const firstId = createUlid(timestamp);
        const secondId = createUlid(timestamp);

        expect(firstId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(secondId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(firstId < secondId).toBe(true);
    });
});
