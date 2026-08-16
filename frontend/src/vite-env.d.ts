/// <reference types="vite/client" />

interface TongyunDesktopBridge {
  platform: string;
  isPackaged: boolean;
  controls: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
  };
}

interface Window {
  tongyunDesktop?: TongyunDesktopBridge;
}
