import { ChatPanel } from '../../components/ChatPanel';

export default function ChatPage({ searchParams }: { searchParams: { c?: string } }) {
  return <ChatPanel initialConversationId={searchParams.c} />;
}
