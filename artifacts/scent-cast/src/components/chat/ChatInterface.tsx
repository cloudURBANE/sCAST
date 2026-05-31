import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, ArrowUp, Command } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Message {
  id: string;
  role: 'user' | 'model';
  parts: { text: string }[];
}

const Typewriter: React.FC<{ text: string; speed?: number }> = ({ text, speed = 30 }) => {
  const [displayedText, setDisplayedText] = useState('');
  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      setDisplayedText(text.slice(0, i));
      i++;
      if (i > text.length) clearInterval(timer);
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed]);
  return <span>{displayedText}</span>;
};

export const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage: Message = {
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(),
      role: 'user',
      parts: [{ text: input }]
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(),
          role: 'model',
          parts: [{ text: "CRITICAL SYSTEM ALERT: Chat interface is currently offline while the nexus is recalibrating." }]
        }
      ]);
      setIsLoading(false);
    }, 500);
  };

  return (
    <div className="max-w-5xl mx-auto h-[80vh] flex flex-col pt-8 bg-white/[0.01] backdrop-blur-sm rounded-[3rem] border border-white/5 shadow-2xl relative overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-16 pb-32 px-12 scroll-smooth">
        <AnimatePresence mode="popLayout">
          {messages.map((m, i) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className={`flex gap-8 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div className={`shrink-0 w-10 h-10 flex items-center justify-center border ${m.role === 'user' ? 'border-white/20 bg-white/5' : 'border-white bg-white shadow-lg'}`}>
                {m.role === 'user' ? <span className="text-white/40 text-xs font-mono">U</span> : <Sparkles size={16} className="text-black" />}
              </div>
              <div className={`flex flex-col gap-3 max-w-[85%] ${m.role === 'user' ? 'items-end' : ''}`}>
                <div className={`text-base leading-[1.6] ${m.role === 'user' ? 'text-white/80 text-right' : 'text-white font-light'}`}>
                  {m.role === 'model' && i === messages.length - 1 ? (
                    <Typewriter text={m.parts[0].text} speed={40} />
                  ) : (
                    m.parts[0].text.split('\n').map((line, idx) => (
                      <p key={idx} className={idx > 0 ? 'mt-4' : ''}>{line}</p>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-full max-w-3xl px-8 z-30">
        <div className="relative group">
          <div className="absolute inset-0 bg-white/[0.03] backdrop-blur-sm rounded-2xl -z-10 border border-white/10 group-focus-within:border-white/20 transition-all duration-500 shadow-xl" />
          <div className="flex items-end gap-4 p-5">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Inject query into nexus network..."
              className="flex-1 bg-transparent border-none outline-none resize-none text-sm font-mono tracking-tight min-h-[50px] max-h-48 pt-3 text-white placeholder:text-white/20"
              rows={1}
            />
            <div className="flex items-center gap-3 pb-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 border border-white/5 rounded-md bg-white/[0.02]">
                <Command size={10} className="text-white/30" />
                <span className="text-[10px] font-mono text-white/30">SEND</span>
              </div>
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className={`p-3 transition-all duration-500 rounded-xl ${input.trim() && !isLoading ? 'bg-white text-black shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:scale-105' : 'text-white/20 border border-white/5 cursor-not-allowed'}`}
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </div>
        <p className="text-center mt-6 text-[9px] font-mono text-white/20 uppercase tracking-[0.5em]">
          Cognitive Link Established // Olfactory Modifiers Synced
        </p>
      </div>
    </div>
  );
};
