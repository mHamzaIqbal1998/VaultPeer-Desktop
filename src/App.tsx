import { TitleBar } from "@/components/TitleBar";
import { WelcomeScreen } from "@/components/WelcomeScreen";

export default function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background-primary text-text-primary">
      <TitleBar />
      <main className="flex-1 overflow-hidden">
        <WelcomeScreen />
      </main>
    </div>
  );
}
