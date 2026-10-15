import axios from 'axios';

export const EMBEDDING_DIMENSION = 512;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://host.docker.internal:11434';
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qllama/bge-small-zh-v1.5:latest';
// bge-small-zh-v1.5 supports 512 tokens; CJK is ~1 char/token — 500 chars is safe
const MAX_CHARS = 500;



export async function getEmbeddings(text: string): Promise<number[]> {
    const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
    const response = await axios.post(`${OLLAMA_HOST}/api/embed`,
        { model: MODEL, input },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
    );

    const data = response.data as { embeddings: number[][] };
    if (!data.embeddings || !data.embeddings[0]) {
        throw new Error(`Ollama embedding failed: invalid response`);
    }
    return data.embeddings[0];
}
