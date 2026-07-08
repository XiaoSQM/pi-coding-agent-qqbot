/**
 * QQ Bot access-token acquisition and caching.
 *
 * Protocol reference: QQ 机器人官方文档 - 接口调用与鉴权
 *   POST https://bots.qq.com/app/getAppAccessToken
 *   body: { appId, clientSecret }
 *   resp: { access_token, expires_in }  (expires_in ~7200 seconds)
 *
 * The token is cached and refreshed shortly before expiry. Secrets and tokens
 * are never logged.
 */

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
// Refresh this many milliseconds before the reported expiry.
const REFRESH_MARGIN_MS = 60_000;

export class QQAuthError extends Error {}

export class QQAuth {
	private readonly appId: string;
	private readonly clientSecret: string;

	private token?: string;
	private expiresAt = 0; // epoch ms
	private inflight?: Promise<string>;

	constructor(appId: string, clientSecret: string) {
		this.appId = appId;
		this.clientSecret = clientSecret;
	}

	/** Returns a valid access token, fetching/refreshing as needed. */
	async getToken(): Promise<string> {
		const now = Date.now();
		if (this.token && now < this.expiresAt - REFRESH_MARGIN_MS) {
			return this.token;
		}
		if (this.inflight) return this.inflight;

		this.inflight = this.fetchToken().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	/** Force the next getToken() to fetch a fresh token. */
	invalidate(): void {
		this.token = undefined;
		this.expiresAt = 0;
	}

	private async fetchToken(): Promise<string> {
		let res: Response;
		try {
			res = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					appId: this.appId,
					clientSecret: this.clientSecret,
				}),
			});
		} catch (err) {
			throw new QQAuthError(
				`token request failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		let body: { access_token?: string; expires_in?: string | number; code?: number; message?: string };
		try {
			body = (await res.json()) as typeof body;
		} catch {
			throw new QQAuthError(`token response not JSON (status ${res.status})`);
		}

		if (!res.ok || !body.access_token) {
			// Do not include the secret in the error.
			const detail = body.message ? `: ${body.message}` : "";
			throw new QQAuthError(`auth failed (status ${res.status})${detail}`);
		}

		const expiresInSec = Number(body.expires_in ?? 7200) || 7200;
		this.token = body.access_token;
		this.expiresAt = Date.now() + expiresInSec * 1000;
		return this.token;
	}
}
