import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App.jsx';
import ChatPanel from './ChatPanel.jsx';

// No host adapter import: the web acceptance page cannot enumerate or send DSH sessions.
createRoot(document.getElementById('root')).render(<App ChatComponent={ChatPanel} />);
