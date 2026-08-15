import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { RegionPicker } from './RegionPicker'
import './index.css'

// The region picker runs in its own window but shares this bundle, selected
// by hash — one Vite entry point covers both.
const isRegionPicker = window.location.hash === '#region'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isRegionPicker ? <RegionPicker /> : <App />}</React.StrictMode>
)
