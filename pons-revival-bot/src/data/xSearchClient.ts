import type { Logger } from "pino";

/** One X account that posted the contract address. */
export interface XMention {
  username: string;
  followers: number | null;
  tweetUrl: string;
}

const SEARCH_URL = "https://api.twitter.com/2/tweets/search/recent";
const REQUEST_TIMEOUT_MS = 8_000;

interface SearchResponse {
  data?: { id: string; author_id?: string }[];
  includes?: { users?: { id: string; username: string; public_metrics?: { followers_count?: number } }[] };
}

/**
 * Finds X accounts that have posted a token's contract address.
 *
 * Searching a contract address is the fastest read on whether a coin has real attention
 * behind it or is being pushed by a handful of throwaway accounts — the follower counts
 * matter as much as the number of posts.
 *
 * X removed free search access in 2023, so this needs a paid Bearer token. Without one the
 * client reports itself unconfigured and every alert simply omits the section: an empty
 * result and "we cannot look" are different things, and the alert should never imply the
 * first when it means the second.
 */
export class XSearchClient {
  constructor(
    private readonly logger: Logger,
    private readonly bearerToken: string
  ) {}

  get configured(): boolean {
    return this.bearerToken.length > 0;
  }

  /**
   * Returns accounts that posted this contract address, most-followed first, or null when
   * the lookup could not be performed (unconfigured, rate-limited, network failure). Null
   * means "unknown" and an empty array means "genuinely nobody" — callers must not conflate
   * them.
   */
  async findMentions(contractAddress: string, limit = 10): Promise<XMention[] | null> {
    if (!this.configured) return null;

    // Exact-string search on the address itself. Retweets are excluded so one post shared
    // ten times does not read as ten accounts talking about the coin.
    const query = `"${contractAddress}" -is:retweet`;
    const url =
      `${SEARCH_URL}?query=${encodeURIComponent(query)}` +
      `&max_results=${Math.min(Math.max(limit, 10), 100)}` +
      `&expansions=author_id&user.fields=username,public_metrics`;

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.bearerToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, contractAddress }, "X search failed");
        return null;
      }
      const body = (await res.json()) as SearchResponse;
      const users = body.includes?.users ?? [];
      const tweets = body.data ?? [];
      if (users.length === 0 || tweets.length === 0) return [];

      const byId = new Map(users.map((u) => [u.id, u]));
      const seen = new Set<string>();
      const mentions: XMention[] = [];
      for (const tweet of tweets) {
        const user = tweet.author_id ? byId.get(tweet.author_id) : undefined;
        if (!user || seen.has(user.username)) continue;
        seen.add(user.username);
        mentions.push({
          username: user.username,
          followers: user.public_metrics?.followers_count ?? null,
          tweetUrl: `https://x.com/${user.username}/status/${tweet.id}`,
        });
      }
      // Most-followed first: whether a real account posted it matters more than how many did.
      mentions.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
      return mentions.slice(0, limit);
    } catch (err) {
      this.logger.warn({ err: String(err), contractAddress }, "X search errored");
      return null;
    }
  }
}
