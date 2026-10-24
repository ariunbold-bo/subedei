/** Hardcoded credentials – UI guard only, not a security boundary. */
const CREDENTIALS = { username: "bagsh", password: "bagsh123" } as const;
const AUTH_KEY = "subedei:authed";

export const isAuthed = (): boolean => localStorage.getItem(AUTH_KEY) === "1";

export const login = (username: string, password: string): boolean => {
  if (username === CREDENTIALS.username && password === CREDENTIALS.password) {
    localStorage.setItem(AUTH_KEY, "1");
    return true;
  }
  return false;
};

export const logout = (): void => localStorage.removeItem(AUTH_KEY);
