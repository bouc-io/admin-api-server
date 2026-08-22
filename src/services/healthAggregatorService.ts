import axios from 'axios';
import https from 'https';

const allowSelfSigned = process.env.ALLOW_SELF_SIGNED_CERTS === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured';

export interface ServiceHealthResult {
    name: string;
    status: ServiceStatus;
    latency_ms: number | null;
    url: string | null;
    lastChecked: string;
}

export interface SystemHealthResult {
    services: ServiceHealthResult[];
    overall: 'healthy' | 'degraded' | 'down';
}

interface ServiceConfig {
    name: string;
    envVar: string;
    probePath: string; // path to append to the base URL for health probe
}

const SERVICES: ServiceConfig[] = [
    { name: 'Agent API',     envVar: 'AGENT_API_URL',   probePath: '/health' },
    { name: 'Memory API',    envVar: 'MEMORY_API_URL',  probePath: '/health' },
    { name: 'Chatbot API',   envVar: 'CHATBOT_API_URL', probePath: '/health' },
    { name: 'LLM (Ollama)',  envVar: 'OLLAMA_URL',      probePath: '/api/tags' },
];

async function checkService(config: ServiceConfig): Promise<ServiceHealthResult> {
    const baseUrl = process.env[config.envVar];
    const lastChecked = new Date().toISOString();

    if (!baseUrl) {
        return { name: config.name, status: 'unconfigured', latency_ms: null, url: null, lastChecked };
    }

    const url = `${baseUrl.replace(/\/$/, '')}${config.probePath}`;
    const start = Date.now();

    try {
        await axios.get(url, {
            timeout: 5000,
            httpsAgent,
            validateStatus: (s) => s < 500, // treat 4xx as reachable
        });
        const latency_ms = Date.now() - start;
        const status: ServiceStatus = latency_ms > 1000 ? 'degraded' : 'healthy';
        return { name: config.name, status, latency_ms, url: baseUrl, lastChecked };
    } catch {
        return { name: config.name, status: 'down', latency_ms: null, url: baseUrl, lastChecked };
    }
}

export async function aggregateHealth(): Promise<SystemHealthResult> {
    const results = await Promise.allSettled(SERVICES.map(checkService));

    const services: ServiceHealthResult[] = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        // Should not happen since checkService never throws, but handle defensively
        return {
            name: SERVICES[i].name,
            status: 'down',
            latency_ms: null,
            url: process.env[SERVICES[i].envVar] || null,
            lastChecked: new Date().toISOString(),
        };
    });

    const configured = services.filter((s) => s.status !== 'unconfigured');
    let overall: SystemHealthResult['overall'] = 'healthy';

    if (configured.length === 0) {
        overall = 'healthy'; // nothing configured → nothing to report
    } else if (configured.every((s) => s.status === 'down')) {
        overall = 'down';
    } else if (configured.some((s) => s.status === 'down' || s.status === 'degraded')) {
        overall = 'degraded';
    }

    return { services, overall };
}
