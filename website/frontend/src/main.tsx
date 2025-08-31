import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ReplayProvider } from './replayContext.tsx'
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Viewer from "./Viewer.tsx"
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReplayProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="viewer" element={<Viewer />} />
        </Routes>
      </BrowserRouter>
    </ReplayProvider>
  </StrictMode>,
)
