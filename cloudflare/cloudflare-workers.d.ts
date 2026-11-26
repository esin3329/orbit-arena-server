/**
 * `cloudflare:workers` 런타임 모듈 중 이 프로젝트가 쓰는 부분만 선언한다.
 *
 * @cloudflare/workers-types 전체를 넣으면 DOM/Node 전역 타입과 충돌하므로, 필요한 표면만 최소로 둔다.
 * 실제 구현은 workerd 가 제공하며, 타입체크(tsc)와 실제 동작은 CI 의 wrangler dev 스모크 테스트가 함께 지킨다.
 */
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: any;
    protected env: Env;
    constructor(ctx: any, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
