import { createContext, useContext } from 'react';

// "Caja común" de la app: App.js arma el value (estado + acciones) y lo provee.
// Cada pantalla/componente toma lo que necesita con useApp().
export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);
