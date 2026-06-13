export const API_URL = 'https://api.faroenergy.lat';

export async function apiFetch(path, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Error del servidor (${res.status})`); }
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}

