import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../app/errorReporting';
import './AppErrorBoundary.css';

type Props = { children: ReactNode };
type State = { failed: boolean };

/**
 * The last line: an error while drawing the app shows a way back instead of a blank page, and is
 * reported (app/errorReporting.ts) with the component it happened in.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (error instanceof Error && info.componentStack) {
      // The component stack says which part of the app; the JavaScript stack alone rarely does.
      const withComponents = new Error(error.message);
      withComponents.name = error.name;
      withComponents.stack = `${error.stack ?? `${error.name}: ${error.message}`}\nIn components:${info.componentStack}`;
      reportError(withComponents);
    } else {
      reportError(error);
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="nu-app-error" role="alert" data-nu-role="app-error">
        <h1 className="nu-app-error__title">Something went wrong</h1>
        <p className="nu-app-error__text">
          Purrlor hit an error it couldn’t recover from. Reloading usually fixes it; nothing you’ve sent is lost.
        </p>
        <button type="button" className="nu-button nu-button--primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
