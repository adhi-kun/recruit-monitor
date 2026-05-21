import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// NO React.StrictMode — it double-invokes effects and breaks Agora RTC + Socket.IO
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
