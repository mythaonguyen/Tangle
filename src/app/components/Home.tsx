import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

const ACCENT_STORAGE_KEY = 'tangle-accent-color';

export function Home() {
  const navigate = useNavigate();
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [accent, setAccent] = useState('#f0b2a8');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (saved) setAccent(saved);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--tangle-accent', accent);
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  }, [accent]);

  const createRoomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  const handleCreateRoom = () => {
    navigate(`/room/${createRoomCode()}`);
  };

  const handleJoinRoom = () => {
    const trimmedCode = roomCodeInput.trim().toUpperCase();
    if (!trimmedCode) return;
    navigate(`/room/${trimmedCode}`);
  };

  return (
    <div className="h-screen w-screen relative overflow-hidden flex flex-col">
      {/* Hero background image + soft gradient wash */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url(/tangle-hero-bg.png)" }}
      />
      <div
        className="absolute inset-0 opacity-85"
        style={{
          background:
            'linear-gradient(165deg, rgba(255,230,240,0.55) 0%, rgba(230,240,255,0.4) 40%, rgba(255,248,230,0.45) 100%)',
        }}
      />

      {/* Decorative glowing arcs */}
      <div className="tangle-arc w-[120%] h-[70%] -left-[10%] top-[5%] opacity-40 blur-[1px]" />
      <div className="tangle-arc w-[90%] h-[55%] right-[-15%] bottom-[10%] opacity-30 blur-[1px]" />

      {/* Top nav */}
      <header className="relative z-20 flex justify-end items-center gap-6 px-6 py-4 text-sm text-white/95 drop-shadow-[0_1px_8px_rgba(0,0,0,0.15)]">
        <a href="#about" className="flex items-center gap-1.5 hover:opacity-90 transition-opacity">
          <span className="text-base leading-none">ⓘ</span>
          <span className="font-medium tracking-wide">About</span>
        </a>
      </header>

      {/* Main */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 pb-24">
        <h1
          className="text-black drop-shadow-sm text-center"
          style={{ fontFamily: "'Alex Brush', cursive", fontWeight: 400, fontSize: 'clamp(4.5rem, 18vw, 9rem)' }}
        >
          Tangle
        </h1>

        <p
          className="tangle-slogan-bounce mt-2 mb-10 text-center text-base sm:text-lg font-medium tracking-wide text-white px-4"
          style={{
            textShadow: '0 0 24px rgba(255,255,255,0.95), 0 0 48px rgba(255,230,180,0.6)',
          }}
        >
          Connect. Discuss. Read together.
        </p>

        <div className="tangle-glass-strong w-full max-w-md rounded-[2rem] p-8 sm:p-10 flex flex-col gap-4">
          <button
            type="button"
            onClick={handleCreateRoom}
            className="tangle-soft-btn w-full py-3.5 rounded-2xl text-base font-semibold transition-transform active:scale-[0.99]"
          >
            Create a New Room
          </button>
          <input
            type="text"
            placeholder="Enter room code"
            value={roomCodeInput}
            onChange={(event) => setRoomCodeInput(event.target.value)}
            className="w-full px-4 py-3.5 rounded-2xl text-center text-[#3d3d3d] placeholder:text-gray-500 outline-none bg-white/55 border border-white/70 shadow-inner"
          />
          <button
            type="button"
            onClick={handleJoinRoom}
            className="tangle-soft-btn w-full py-3.5 rounded-2xl text-base font-semibold transition-transform active:scale-[0.99]"
          >
            Join Room
          </button>
        </div>
      </div>

      {/* About (in-page anchor from nav) */}
      <section
        id="about"
        className="relative z-10 max-w-lg mx-auto px-6 pb-4 text-center text-sm text-white/90 drop-shadow-md"
      >
        <p>
          Tangle is a cozy space for reading groups: share a room link, track progress together, and discuss
          without spoilers.
        </p>
      </section>
    </div>
  );
}
