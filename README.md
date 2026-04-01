# Airbnb Search & Listings - Desktop Extension (DXT)

A comprehensive Desktop Extension for searching Airbnb listings with advanced filtering capabilities and detailed property information retrieval. Built as a Model Context Protocol (MCP) server packaged in the Desktop Extension (DXT) format for easy installation and use with compatible AI applications.

## Features

### 🔍 Advanced Search Capabilities
- **Location-based search** with support for cities, states, and regions
- **Google Maps Place ID** integration for precise location targeting
- **Date filtering** with check-in and check-out date support
- **Guest configuration** including adults, children, infants, and pets
- **Price range filtering** with minimum and maximum price constraints
- **Pagination support** for browsing through large result sets
- **Context-aware ranking** with budget, rating, and amenity prioritization
- **Context middleware** that extracts missing structured fields from free-form traveler context

### 🏠 Detailed Property Information
- **Comprehensive listing details** including amenities, policies, and highlights
- **Location information** with coordinates and neighborhood details
- **House rules and policies** for informed booking decisions
- **Property descriptions** and key features
- **Direct links** to Airbnb listings for easy booking
- **Compact-by-default responses** to reduce model context usage

### 🛡️ Security & Compliance
- **Robots.txt compliance** with configurable override for testing
- **Request timeout management** to prevent hanging requests
- **Enhanced error handling** with detailed logging
- **Rate limiting awareness** and respectful API usage
- **Secure configuration** through DXT user settings

## Installation

### For Claude Desktop
This extension is packaged as a Desktop Extension (DXT) file. To install:

1. Download the `.dxt` file from the releases page
2. Open your compatible AI application (e.g., Claude Desktop)
3. Install the extension through the application's extension manager
4. Configure the extension settings as needed

### For Cursor, etc.

Before starting make sure [Node.js](https://nodejs.org/) is installed on your desktop for `npx` to work.
1. Go to: Cursor Settings > Tools & Integrations > New MCP Server

2. Add one the following to your `mcp.json`:
    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb"
          ]
        }
      }
    }
    ```

    To ignore robots.txt for all requests, use this version with `--ignore-robots-txt` args

    ```json
    {
      "mcpServers": {
        "airbnb": {
          "command": "npx",
          "args": [
            "-y",
            "@openbnb/mcp-server-airbnb",
            "--ignore-robots-txt"
          ]
        }
      }
    }
    ```
3. Restart.


### Docker

Build and run the MCP server container locally:

```bash
docker build -t airbnb-mcp-server .
docker run --rm -it airbnb-mcp-server
```

To ignore robots.txt for testing:

```bash
docker run --rm -it airbnb-mcp-server node dist/index.js --ignore-robots-txt
```

Example with context/tuning environment variables:

```bash
docker run --rm -it \
  -e AIRBNB_DEFAULT_CONTEXT_RESULTS=6 \
  -e AIRBNB_MAX_SEARCH_RESULTS=25 \
  airbnb-mcp-server
```

If you prefer Docker Compose, use the provided `docker-compose.yml`:

```bash
docker compose up --build
```

You can pass the context-related settings below via `docker run` or `docker compose`:

- `AIRBNB_DEFAULT_CONTEXT_RESULTS` (default: `6`)
- `AIRBNB_MAX_SEARCH_RESULTS` (default: `25`)
- `AIRBNB_CONTEXT_SUMMARY_LENGTH` (default: `180`)
- `AIRBNB_DETAIL_SUMMARY_LENGTH` (default: `500`)

## Configuration

The extension provides the following user-configurable options:

### Ignore robots.txt
- **Type**: Boolean (checkbox)
- **Default**: `false`
- **Description**: Bypass robots.txt restrictions when making requests to Airbnb
- **Recommendation**: Keep disabled unless needed for testing purposes

## Context middleware

The `airbnb_search_contextual` tool accepts a free-form `context` string.  
The middleware parses signals and only fills fields that were not explicitly provided.

- Parsed signals can include location, date spans, guests, budget, rating, and amenity intent.
- Explicit arguments always override context-derived values.
- `location` may be omitted in contextual search if it can be inferred from context.

Example:

```json
{
  "context": "romantic trip, checkin next Friday checkout Sunday, 2 adults and 1 child, budget under 250, must have pool and Wi-Fi, avoid noisy neighborhoods, rating at least 4.5"
}
```

Response includes:

- `context.source`: original context text
- `context.parsed`: extracted raw signals
- `context.usage`: which parameters were sourced from context
- `context.resolved`: final effective search parameters

## Tools

### `airbnb_search`

Search for Airbnb listings with comprehensive filtering options.

**Parameters:**
- `location` (required): Location to search (e.g., "San Francisco, CA")
- `placeId` (optional): Google Maps Place ID (overrides location)
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `minPrice` (optional): Minimum price per night
- `maxPrice` (optional): Maximum price per night
- `cursor` (optional): Pagination cursor for browsing results
- `ignoreRobotsText` (optional): Override robots.txt for this request
- `compact` (optional, default: `true`): Return compact summaries for each listing
- `maxResults` (optional): Limit result count sent back
- `includeFields` (optional): Return only selected top-level fields in compact mode

**Returns:**
- Search results with property details, pricing, and direct links
- Pagination information for browsing additional results
- Search URL for reference

### `airbnb_listing_details`

Get detailed information about a specific Airbnb listing.

**Parameters:**
- `id` (required): Airbnb listing ID
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `ignoreRobotsText` (optional): Override robots.txt for this request
- `compact` (optional, default: `true`): Return compact sections by default
- `includeSections` (optional): Restrict sections by section ID list in compact/full response

**Returns:**
- Detailed property information including:
  - Location details with coordinates
  - Amenities and facilities
  - House rules and policies
  - Property highlights and descriptions
  - Direct link to the listing

### `airbnb_search_contextual`

Search and rank listings using traveler constraints:

**Parameters:**
- `location` (optional): Location to search (e.g., "San Francisco, CA")
- `checkin` (optional): Check-in date in YYYY-MM-DD format
- `checkout` (optional): Check-out date in YYYY-MM-DD format
- `adults` (optional): Number of adults (default: 1)
- `children` (optional): Number of children (default: 0)
- `infants` (optional): Number of infants (default: 0)
- `pets` (optional): Number of pets (default: 0)
- `minPrice` (optional): Minimum price per night
- `maxPrice` (optional): Maximum price per night
- `compact` (optional, default: `true`): Return compact ranking output
- `maxResults` (optional): Limit ranked recommendations
- `maxPricePerNight` (optional): Budget cap used for ranking
- `minRating` (optional): Minimum rating threshold for scoring
- `mustHaveAmenities` (optional): Amenities that should be present for stronger ranking
- `preferredAmenities` (optional): Amenities that increase ranking confidence
- `avoidAmenities` (optional): Amenities to de-prioritize candidates
- `ignoreRobotsText` (optional): Override robots.txt for this request
- `context` (optional): Free-form traveler context used as a fallback when fields are missing

**Returns:**
- Ranked recommendations with `matchScore` and `matchReasons`
- Parsed context breakdown echoed back (including inferred location, dates, guests, budget, rating, amenities, and which fields came from context)
- Pagination metadata from source search query

**Notes:**
- Provide a free-form `context` string to let the server infer missing fields (location, checkin, checkout, guests, budget/rating, amenity signals).
- The parser is defensive and only applies inferred fields when explicit arguments are not provided.
- If both explicit values and inferred context values exist, explicit ones are used.

## Technical Details

### Architecture
- **Runtime**: Node.js 18+
- **Protocol**: Model Context Protocol (MCP) via stdio transport
- **Format**: Desktop Extension (DXT) v0.1
- **Dependencies**: Minimal external dependencies for security and reliability

### Error Handling
- Comprehensive error logging with timestamps
- Graceful degradation when Airbnb's page structure changes
- Timeout protection for network requests
- Detailed error messages for troubleshooting

### Security Measures
- Robots.txt compliance by default
- Request timeout limits
- Input validation and sanitization
- Secure environment variable handling
- No sensitive data storage

### Performance
- Efficient HTML parsing with Cheerio
- Request caching where appropriate
- Minimal memory footprint
- Fast startup and response times

## Compatibility

- **Platforms**: macOS, Windows, Linux
- **Node.js**: 18.0.0 or higher
- **Claude Desktop**: 0.10.0 or higher
- **Other MCP clients**: Compatible with any MCP-supporting application

## Development

### Building from Source

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch for changes during development
npm run watch
```

### Testing

The extension can be tested by running the MCP server directly:

```bash
# Run with robots.txt compliance (default)
node dist/index.js

# Run with robots.txt ignored (for testing)
node dist/index.js --ignore-robots-txt
```

## Legal and Ethical Considerations

- **Respect Airbnb's Terms of Service**: This extension is for legitimate research and booking assistance
- **Robots.txt Compliance**: The extension respects robots.txt by default
- **Rate Limiting**: Be mindful of request frequency to avoid overwhelming Airbnb's servers
- **Data Usage**: Only extract publicly available information for legitimate purposes

## Support

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/openbnb-org/mcp-server-airbnb/issues)
- **Documentation**: Additional documentation available in the repository
- **Community**: Join discussions about MCP and DXT development

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read the contributing guidelines and submit pull requests for any improvements.

---

**Note**: This extension is not affiliated with Airbnb, Inc. It is an independent tool designed to help users search and analyze publicly available Airbnb listings.
