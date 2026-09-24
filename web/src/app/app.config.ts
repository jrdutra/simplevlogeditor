import { ApplicationConfig } from '@angular/core';
import {
  provideRouter,
  RouteReuseStrategy,
  withComponentInputBinding,
  withInMemoryScrolling
} from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideClientHydration } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

import { routes } from './app.routes';
import { ToolRouteReuseStrategy } from './shared/ui/tool-route-reuse';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: RouteReuseStrategy, useClass: ToolRouteReuseStrategy },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'enabled'
      })
    ),
    provideClientHydration(),
    provideAnimationsAsync(),
    provideHttpClient(withFetch())
  ]
};
