# Meta app setup (Facebook Login for Business)

The panel signs in to Meta once per person who owns ad accounts and imports every ad account and Page
that login can reach. There is no account limit.

## 1. Create the app

1. Go to developers.facebook.com → My Apps → Create app → type **Business**.
2. Connect it to your Business Manager (Business portfolio).
3. Add the products **Facebook Login for Business** and **Marketing API**.

## 2. Create a Login for Business configuration

Facebook Login for Business → Configurations → Create.

- Login variation: **General**
- Access token: **User access token**
- Permissions: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`

Save it and copy the **Configuration ID** into `META_CONFIG_ID`.

## 3. Redirect URI

Facebook Login for Business → Settings → Valid OAuth Redirect URIs:

```
https://proads.smenterpriserl1987.com/api/meta/callback
```

Set exactly the same value in `META_REDIRECT_URI`. The app refuses to start if it is not on `APP_ORIGIN`.

## 4. Environment variables

| Key | Where to find it |
| --- | --- |
| `META_APP_ID` | App settings → Basic → App ID |
| `META_APP_SECRET` | App settings → Basic → App secret (keep it only in hPanel) |
| `META_CONFIG_ID` | Step 2 |
| `META_API_VERSION` | The Graph API version you build and test against, for example `v24.0`. Check the current version in Meta's changelog before go-live and keep it pinned. |
| `META_REDIRECT_URI` | Step 3 |

## 5. Connect

Restart the app, open **Ad Accounts** and press **Connect Meta**. After you approve, the panel imports
accounts and Pages straight away and re-syncs every 5 minutes. Tokens are checked hourly; if one expires
you get a notification to reconnect.

## App review and access level

While the app is in development mode only people with a role on the app can connect. Advanced Access for
`ads_management` and the other permissions needs Meta App Review before other users can connect.

## What has been verified

The Meta client is covered by automated tests against recorded Meta responses (error handling, paging,
parameter encoding). **It has not yet been tested against a live Meta app.** System Health will show
*Live check* for Meta only after a real token is inspected successfully.
