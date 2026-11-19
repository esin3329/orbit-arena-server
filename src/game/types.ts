/**
 * 룸이 플레이어에게 메시지를 보내기 위한 최소 인터페이스.
 * WebSocket 에 직접 의존하지 않으므로 테스트에서 가짜 연결로 대체할 수 있다.
 */
export interface PlayerConnection {
  readonly playerId: string;
  readonly nickname: string;
  send(data: string): void;
  /** 송신 버퍼가 밀려 있으면 true → 해당 클라이언트의 스냅샷을 건너뛴다(느린 소비자 보호) */
  isCongested(): boolean;
}

export interface PlayerInput {
  seq: number;
  dx: number;
  dy: number;
  aim: number;
  fire: boolean;
  dash: boolean;
  /** 입력 당시 클라이언트가 화면에 그리던 서버 틱 (지연 보상용, 선택) */
  rt?: number;
}
