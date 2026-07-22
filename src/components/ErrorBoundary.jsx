import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { getAppMessage } from '../copy/appMessages.js';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const t = this.props.translate || getAppMessage;
      return (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', margin: '1rem' }}>
          <AlertTriangle size={48} style={{ marginBottom: '1rem' }} />
          <h2>{t('errorBoundary.title')}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{this.state.error?.toString()}</p>
          <button 
            onClick={() => window.location.reload()} 
            style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {t('errorBoundary.reload')}
          </button>
        </div>
      );
    }

    return this.props.children; 
  }
}

export default ErrorBoundary;
