import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'overlay',
    loadComponent: () => import('./overlay/overlay.component').then((m) => m.OverlayComponent),
  },
  {
    path: 'capture',
    loadComponent: () => import('./capture/capture.component').then((m) => m.CaptureComponent),
  },
  {
    path: 'settings',
    loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: '',
    redirectTo: 'overlay',
    pathMatch: 'full',
  },
];
