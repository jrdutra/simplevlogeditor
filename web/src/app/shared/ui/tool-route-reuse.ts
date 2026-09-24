import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

/** Keep the loaded timeline, media handles and undo history when changing tabs. */
@Injectable()
export class ToolRouteReuseStrategy implements RouteReuseStrategy {
  private editor: DetachedRouteHandle | null = null;
  shouldDetach(route: ActivatedRouteSnapshot): boolean { return route.routeConfig?.path === 'video-editor'; }
  store(_route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void { this.editor = handle; }
  shouldAttach(route: ActivatedRouteSnapshot): boolean { return this.shouldDetach(route) && this.editor !== null; }
  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null { return this.shouldDetach(route) ? this.editor : null; }
  shouldReuseRoute(future: ActivatedRouteSnapshot, current: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === current.routeConfig;
  }
}
