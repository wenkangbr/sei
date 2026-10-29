-- Client-only: the host's app exposes a read-only local status endpoint.
local G = GLOBAL
local require = G.require
local ipairs, pcall, type = G.ipairs, G.pcall, G.type
local tostring, tonumber, math, string = G.tostring, G.tonumber, G.math, G.string
local Text = require("widgets/text")
local ImageButton = require("widgets/imagebutton")
local TextEdit = require("widgets/textedit")
local Image = require("widgets/image")

-- The server helper registers the real handler. A remote client needs the
-- matching local RPC id too; the handler itself only executes on the server.
if G.TheNet ~= nil and not G.TheNet:GetIsServer() then
    AddModRPCHandler("sei_panel", "action", function() end)
end

local PORTS = { 27424, 27425, 27426, 27427, 27428 }
local commands = {
    { "快跟上", "快跟上我" },
    { "砍树", "帮我砍树" },
    { "挖矿", "帮我挖矿" },
    { "保护我", "请保护我，跟紧我" },
    { "存材料", "把材料放到附近的仓库里" },
}
local activity = {
    idle = "待命", ["goto"] = "移动", follow = "跟随", gather = "采集",
    action = "工作", build = "制作", attack = "战斗", flee = "撤退",
    lightfire = "照料火堆", container = "整理物品", give = "递送物品",
}
local function rounded(value)
    return math.floor((tonumber(value) or 0) + .5)
end

local function button(parent, title, x, y, onclick)
    local b = parent:AddChild(ImageButton("images/global.xml", "square.tex", "square.tex", "square.tex"))
    b:SetPosition(x, y)
    b:ForceImageSize(78, 30)
    b:SetFont(G.TALKINGFONT)
    b:SetTextSize(18)
    b:SetTextColour(0, 0, 0, 1)
    b.scale_on_focus = false
    b:SetText(title)
    b:SetOnClick(onclick)
    return b
end

local function addHud(controls)
    if controls.seiHud ~= nil or controls.topleft_root == nil then return end
    local root = controls.topleft_root:AddChild(require("widgets/widget")("SeiHud"))
    controls.seiHud = root
    root:SetPosition(205, -150)
    root:Hide()
    local details
    local card = button(root, "Sei", 0, 0, function()
        if details.shown then details:Hide() else details:Show() end
    end)
    card:ForceImageSize(390, 36)
    card:SetTextSize(22)
    details = root:AddChild(require("widgets/widget")("SeiDetails"))
    details:Show()
    local info = details:AddChild(Text(G.TALKINGFONT, 20, ""))
    info:SetPosition(0, -48)
    info:SetClickable(false)
    local notice = details:AddChild(Text(G.TALKINGFONT, 18, ""))
    notice:SetPosition(0, -120)
    notice:SetClickable(false)
    local function send(action, message)
        local ok = pcall(function()
            SendModRPCToServer(GetModRPC("sei_panel", "action"), action, message or "")
        end)
        notice:SetString(ok and (action == "call" and "已请求呼唤" or "已发送给 AI") or "发送失败，请检查模组版本")
    end
    local background = details:AddChild(Image("images/global.xml", "square.tex"))
    background:SetPosition(-35, -155)
    background:SetSize(300, 32)
    background:SetTint(1, 1, 1, .9)
    background:SetClickable(false)
    local edit = details:AddChild(TextEdit(G.TALKINGFONT, 20, ""))
    edit:SetPosition(-35, -155)
    edit:SetRegionSize(300, 32)
    edit:SetTextLengthLimit(120)
    edit:SetTextPrompt("点击输入，回车发送")
    edit:SetString("")
    local function sendText()
        local message = edit:GetString()
        if type(message) ~= "string" or not message:match("%S") then return end
        send("chat", message)
        edit:SetString("")
    end
    edit.OnTextEntered = sendText
    button(details, "发送", 160, -155, sendText)
    button(details, "呼唤", 160, -195, function() send("call") end)
    local quick = {}
    for i, spec in ipairs(commands) do
        local command = spec[2]
        quick[i] = button(details, spec[1], (i - 3) * 82, -235, function() send("chat", command) end)
    end
    local activePort = nil
    local function poll(port)
        G.TheSim:QueryServer("http://127.0.0.1:" .. tostring(port) .. "/hud", function(result, ok, code)
            if not ok or code ~= 200 then
                if activePort == port then activePort = nil; root:Hide() end
                return
            end
            local success, data = pcall(G.json.decode, result)
            if not success or type(data) ~= "table" or data.app ~= "sei" then return end
            activePort = port
            local s = data.companion
            if type(s) ~= "table" then root:Hide(); return end
            root:Show()
            card:SetText(tostring(s.name or "Sei") .. "  ·  " .. (activity[s.activity] or tostring(s.activity or "待命")))
            info:SetString(string.format("生命 %d/%d    饥饿 %d/%d    理智 %d/%d\n体温 %s    背包 %d 格    %s",
                rounded(s.health), rounded(s.healthMax), rounded(s.hunger), rounded(s.hungerMax), rounded(s.sanity), rounded(s.sanityMax),
                s.temperature ~= nil and (tostring(rounded(s.temperature)) .. "°") or "--", rounded(s.inventoryCount), s.dead and "已死亡" or "存活"))
        end, "GET")
    end
    root.inst:DoPeriodicTask(2, function()
        if activePort ~= nil then poll(activePort) else for _, port in ipairs(PORTS) do poll(port) end end
    end, 0)
end

AddClassPostConstruct("widgets/controls", addHud)
