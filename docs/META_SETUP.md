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
- Permissions: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`,
  and since 0.8.0 for the Comments page: `pages_read_user_content`, `pages_manage_engagement`

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

## "Requires business_management permission"

This means the login did not grant `business_management`. Facebook Login for Business only grants the permissions
listed in the **configuration**, not what the panel asks for, so:

1. App dashboard → **Use cases** (or App Review → Permissions and Features): make sure `business_management` is added to the app.
   In development mode it works without review for people with a role on the app.
2. Facebook Login for Business → **Configurations** → open the configuration whose ID is in `META_CONFIG_ID` → edit
   **Permissions** → tick `business_management` (and the others listed in step 2) → save. If you create a new configuration
   instead, put its new ID in `META_CONFIG_ID` and restart the app.
3. Remove the old grant so Meta asks again: facebook.com → Settings → **Business integrations** → remove the app.
4. In the panel press **Connect Meta** again and approve everything, including the businesses and ad accounts you want.

Since 0.3.3 the panel still imports your ad accounts and Pages without this permission (only business names are missing)
and shows which permissions are missing next to the Meta login.

## "Missing permissions: pages_read_user_content, pages_manage_engagement"

Shown after Connect Meta since 0.8.0. Everything else keeps working; only the **Comments** page needs these two.

1. developers.facebook.com → your app → **Use cases** → the use case that holds Facebook Login for Business
   (or **App Review → Permissions and Features**) → search `pages_read_user_content` → **Add**; same for
   `pages_manage_engagement`. In development mode they work at once for people with a role on the app.
2. **Facebook Login for Business → Configurations** → open the configuration whose ID is in `META_CONFIG_ID` → **Edit**
   → under Permissions tick both → **Save**. The ID does not change.
3. facebook.com → Settings & privacy → Settings → **Business integrations** → remove the app, so Meta asks again.
4. In the panel: Ad Accounts → **Connect Meta** → approve everything, including the Pages.

If the app is **Live** (not development), these two permissions need Advanced Access through App Review before
anyone can grant them. Until then keep the app in development mode with your team as app admins or testers,
or leave Comments unused: nothing else depends on it.

## App review and access level

While the app is in development mode only people with a role on the app can connect. Advanced Access for
`ads_management` and the other permissions needs Meta App Review before other users can connect.

## What has been verified

The Meta client is covered by automated tests against recorded Meta responses (error handling, paging,
parameter encoding). **It has not yet been tested against a live Meta app.** System Health will show
*Live check* for Meta only after a real token is inspected successfully.
