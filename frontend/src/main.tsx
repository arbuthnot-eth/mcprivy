import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { PrivyProvider } from '@privy-io/react-auth';
import { Buffer } from 'buffer';

// Configure the Buffer polyfill for global use
window.Buffer = Buffer;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'sms', 'wallet', 'google', 'apple'],
        embeddedWallets: {
          createOnLogin: 'all-users',
          showWalletUIs: true,
        },
        appearance: {
          theme: 'light',
          accentColor: '#676FFF',
        },
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>
);