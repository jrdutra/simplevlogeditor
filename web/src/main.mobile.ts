import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import {
  provideRouter, RouteReuseStrategy, withComponentInputBinding, withInMemoryScrolling
} from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { ToolRouteReuseStrategy } from './app/shared/ui/tool-route-reuse';

// The APK contains a client-only build; there is no SSR document to hydrate.
bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: ToolRouteReuseStrategy },
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({
      scrollPositionRestoration: 'top', anchorScrolling: 'enabled'
    })),
    provideAnimationsAsync(),
    provideHttpClient(withFetch())
  ]
}).catch(error => console.error(error));
