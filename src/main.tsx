import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FractalViewer from "./FractalViewer.tsx";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FractalViewer />
  </StrictMode>,
)
