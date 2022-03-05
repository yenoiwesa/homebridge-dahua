# Homebridge Dahua Intercom

A Homebridge plugin providing support for the **Dahua** intercom system.

It allows to unlock doors connected to a Dahua VTO system.

# Requirements

-   **Node** version 11 or above (verify with `node --version`).
-   **Homebridge** version 1.0.0 or above.

# Installation

1. Install homebridge using:

```sh
npm install -g homebridge
```

2. Install the plugin using:

```sh
npm install -g https://github.com/yenoiwesa/homebridge-dahua
```

3. Update your configuration file. See bellow for a sample.

> **Note:** it is also possible to install this plugin in a local `npm` package instead using the homebridge option `--plugin-path`.

# Configuration

## General settings

To configure `homebridge-dahua`, add the `DahuaIntercom` accesory to the `accessories` section of your homebridge's `config.js` file:

```json
{
    "bridge": { "...": "..." },

    "description": "...",

    "accessories": [
        {
            "accessory": "DahuaIntercom",
            "name": "Front door",
            "shortNumber": "{Your unit's short number}",
            "ip": "192.168.x.x"
        }
    ]
}
```
