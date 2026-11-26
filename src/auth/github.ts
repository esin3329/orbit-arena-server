import { createClient } from '@supabase/supabase-js';

const STORAGE_KEY = 'orbit-arena-github';
const VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`;
export const GITHUB_CALLBACK = '/api/auth/github/callback';
export const GITHUB_SESSION = '/api/auth/github/session';

export function createGitHubAuth(supabaseUrl: string, publishableKey: string, origin: string) {
  function client(savedVerifier?: string) {
    const values = new Map<string, string>();
    if (savedVerifier) values.set(VERIFIER_KEY, savedVerifier);
    const sb = createClient(supabaseUrl, publishableKey, {
      auth: {
        flowType: 'pkce',
        storageKey: STORAGE_KEY,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => { values.set(key, value); },
          removeItem: (key) => { values.delete(key); },
        },
      },
    });
    return { auth: sb.auth, values };
  }

  return {
    origin,
    secure: new URL(origin).protocol === 'https:',
    async start() {
      const { auth, values } = client();
      const { data, error } = await auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: origin + GITHUB_CALLBACK, skipBrowserRedirect: true },
      });
      const verifier = values.get(VERIFIER_KEY);
      if (error || !data.url || !verifier) throw new Error('Unable to start GitHub login');
      return { url: data.url, verifier: Buffer.from(verifier).toString('base64url') };
    },
    async exchange(code: string, verifier: string) {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(verifier) || code.length > 512) return null;
      const { auth } = client(Buffer.from(verifier, 'base64url').toString('utf8'));
      const { data, error } = await auth.exchangeCodeForSession(code);
      const user = data.user;
      if (error || !user?.identities?.some((identity) => identity.provider === 'github')) return null;
      const username = user.user_metadata?.user_name;
      const nickname = typeof username === 'string' && /^[a-z\d-]{2,}$/i.test(username)
        ? username.slice(0, 16)
        : `GitHub-${user.id.slice(0, 8)}`;
      return { id: user.id, nickname };
    },
  };
}
