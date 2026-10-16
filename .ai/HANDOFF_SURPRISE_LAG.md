# Handoff: surprise lag / freeze
See the "Surprise lag / freeze fix" entry in .ai/CHANGELOG.md for root causes and files:
src/hooks/useDeviceTilt.ts, src/hooks/useChatSurprise.ts, src/components/surprise/SurpriseReveal.tsx,
src/components/chat/MessageTimeline.tsx (VirtualRow), src/components/chat/SurpriseMessage.tsx.
Verify on device: open a surprise (glass + expanded), tilt phone, close; chat should stay smooth and no
re-render storm. If it still stalls, capture a Chrome remote-debug Performance trace during open and send it.
Run before shipping: npm run verify:lock && npm run build, then vitest + tsc.
