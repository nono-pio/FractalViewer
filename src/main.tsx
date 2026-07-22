import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import FractalViewer from "./FractalViewer.tsx";

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <FractalViewer
            width={400}
            height={400}
            iteration={40}
            time_per_iteration={0.1}
            color_mode={"green"}
        />
    </StrictMode>,
)
