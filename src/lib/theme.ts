export type ThemePreference = 'dark' | 'light' | 'system';

export function resolveIsDark(pref: ThemePreference): boolean {
	if (pref === 'system') {
		return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
	}
	return pref !== 'light';
}

/** Applies the theme to the document and persists it, so every page (including auth/onboarding) stays in sync. */
export function applyTheme(pref: ThemePreference) {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('dark', resolveIsDark(pref));
	try {
		localStorage.setItem('theme', pref);
	} catch {
		// ignore
	}
}

export function loadStoredTheme(): ThemePreference {
	try {
		const stored = localStorage.getItem('theme');
		if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
	} catch {
		// ignore
	}
	return 'dark';
}
