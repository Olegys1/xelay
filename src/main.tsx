import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { OfflineAppEntry } from './components/OfflineAppEntry'
import { registerOfflineShell } from './lib/offlineShell'
import './index.css'

void registerOfflineShell()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <OfflineAppEntry><App /></OfflineAppEntry>
    </ThemeProvider>
  </React.StrictMode>,
)
