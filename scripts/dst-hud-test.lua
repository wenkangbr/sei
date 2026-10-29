local function widget()
    local w = { children = {}, shown = true, text = '' }
    w.inst = { DoPeriodicTask = function(_, _, fn) w.poll = fn end }
    function w:AddChild(child) table.insert(self.children, child); return child end
    function w:SetPosition() end
    function w:Hide() self.shown = false end
    function w:Show() self.shown = true end
    function w:ForceImageSize() end
    function w:SetFont() end
    function w:SetTextSize() end
    function w:SetTextColour() end
    function w:SetText(s) self.text = s end
    function w:SetString(s) self.text = s end
    function w:GetString() return self.text end
    function w:SetClickable() end
    function w:SetOnClick(fn) self.onclick = fn end
    function w:SetRegionSize() end
    function w:SetSize() end
    function w:SetTint() end
    function w:SetTextLengthLimit() end
    function w:SetTextPrompt() end
    return w
end

local sent, response, hook, registered = {}, nil, nil, false
local modules = {
    ['widgets/text'] = function() return widget() end,
    ['widgets/textedit'] = function() return widget() end,
    ['widgets/imagebutton'] = function() return widget() end,
    ['widgets/image'] = function() return widget() end,
    ['widgets/widget'] = function() return widget() end,
}
GLOBAL = {
    ipairs = ipairs, pcall = pcall, type = type, tostring = tostring,
    tonumber = tonumber, math = math, string = string,
    require = function(name) return assert(modules[name], name) end,
    TALKINGFONT = 'font', json = { decode = function() return response end },
    TheNet = { GetIsServer = function() return false end },
    TheSim = { QueryServer = function(_, _, cb) cb('json', true, 200) end },
}
local modEnv = {
    GLOBAL = GLOBAL,
    AddModRPCHandler = function(ns, name) assert(ns == 'sei_panel' and name == 'action'); registered = true end,
    GetModRPC = function(ns, name) assert(registered and ns == 'sei_panel' and name == 'action'); return 1 end,
    SendModRPCToServer = function(id, action, message) assert(id == 1); table.insert(sent, {action, message}) end,
    AddClassPostConstruct = function(name, fn) assert(name == 'widgets/controls'); hook = fn end,
}
assert(loadfile('native/dst-mod/sei_hud/modmain.lua', 't', modEnv))()
local controls = { topleft_root = widget() }
hook(controls)
local root = controls.seiHud
assert(not root.shown)
response = { app = 'sei', companion = { name = '小伙伴', health = 50, healthMax = 100, hunger = 30, hungerMax = 100, sanity = 90, sanityMax = 100, activity = 'chop', temperature = 23, inventoryCount = 4 } }
root.poll()
assert(root.shown)
assert(root.children[1].text:find('小伙伴', 1, true))
local details = root.children[2]
assert(details.children[1].text:find('生命 50/100', 1, true))
assert(details.children[1].text:find('背包 4 格', 1, true))
local edit = details.children[4]
edit:SetString('你好')
edit.OnTextEntered()
assert(sent[1][1] == 'chat' and sent[1][2] == '你好' and edit.text == '')
details.children[6].onclick()
assert(sent[2][1] == 'call')
local expected = { '快跟上我', '帮我砍树', '帮我挖矿', '请保护我，跟紧我', '把材料放到附近的仓库里' }
for i = 1, 5 do details.children[i + 6].onclick(); assert(sent[i + 2][2] == expected[i]) end
root.children[1].onclick(); assert(not details.shown)
response = { app = 'sei' }; root.poll(); assert(not root.shown)
print('DST HUD interaction test passed')
