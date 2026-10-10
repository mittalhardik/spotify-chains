import dashboard from './dashboard.html';
import login from './login.html';

export const dashboardHtml = dashboard;

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function loginHtml(error = ''): string {
  return login.replace('{{ERROR}}', error ? `<p class="error">${escape(error)}</p>` : '');
}

export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#121212"/><g fill="none" stroke="#1ed760" stroke-width="5" stroke-linecap="round"><circle cx="20" cy="32" r="8"/><circle cx="44" cy="32" r="8"/><path d="M28 32h8"/></g></svg>`;

export const manifest = {
  name: 'Spotify Chains',
  short_name: 'Chains',
  start_url: '/',
  display: 'standalone',
  background_color: '#121212',
  theme_color: '#121212',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
};
