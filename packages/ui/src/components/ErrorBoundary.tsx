import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error?: Error;
}

/**
 * Last-resort boundary (FR-7.11). A render error must produce a readable page,
 * not a blank one — an observability tool that fails silently is self-defeating.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Anvaya UI crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ padding: 40, maxWidth: 700, margin: '0 auto' }}>
        <div className="state state-error" role="alert">
          <div className="state-title">The dashboard hit a rendering error</div>
          <p>{this.state.error.message}</p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
