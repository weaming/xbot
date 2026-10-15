import { randomBytes } from "crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RANDOM_BITS = 80n;
const ULID_RANDOM_MASK = (1n << ULID_RANDOM_BITS) - 1n;
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const ULID_MAX_TIMESTAMP = 2 ** 48 - 1;

let lastTimestamp = -1;
let lastRandomValue = 0n;

/** 创建按时间排序且在当前进程内单调递增的 ULID。 */
export function createUlid(date: Date = new Date()): string {
    const timestamp = Math.max(date.getTime(), lastTimestamp);
    if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > ULID_MAX_TIMESTAMP) {
        throw new Error(`ULID timestamp is out of range: ${timestamp}`);
    }

    let randomValue = randomBigInt();
    if (timestamp === lastTimestamp) {
        randomValue = lastRandomValue + 1n;
        if (randomValue > ULID_RANDOM_MASK) {
            throw new Error("ULID random component overflowed within one millisecond");
        }
    }

    lastTimestamp = timestamp;
    lastRandomValue = randomValue;

    return encodeBase32(BigInt(timestamp), ULID_TIME_LENGTH) + encodeBase32(randomValue, ULID_RANDOM_LENGTH);
}

function randomBigInt(): bigint {
    return BigInt(`0x${randomBytes(10).toString("hex")}`);
}

function encodeBase32(value: bigint, length: number): string {
    let result = "";

    for (let index = length - 1; index >= 0; index -= 1) {
        const shift = BigInt(index * 5);
        const alphabetIndex = Number((value >> shift) & 31n);
        result += ULID_ALPHABET[alphabetIndex];
    }

    return result;
}
